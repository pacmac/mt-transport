#!/bin/bash
# push-status.sh — answer "what is happening RIGHT NOW" without asking the radio.
#
# READ-ONLY BY DEFAULT: it reads node-dash's HTTP API and local log/process state.
# It puts NOTHING on air, so it is safe to run during a transfer — unlike polling
# `push stat`, which is text at hop 3 and demonstrably slows the thing you are
# watching.
#
# Usage:  ./push-status.sh          one snapshot
#         ./push-status.sh -w       refresh every 5 s (Ctrl-C to stop)

GW=${GW:-localhost:8000}
BENCH=2364420971          # !8cee336b "U33B" — the bench unit
FIELD=2558179343          # !987ab80f "DEV1" — OFF LIMITS, never a target
LOG=${LOG:-/tmp/onair.log}

snapshot() {
  echo "======== $(date '+%H:%M:%S') ========"

  # 1. Is a transfer process alive at all? This is the "has it hung?" question.
  # -f matches this script's own cmdline too; exclude self and our parent.
  local pids
  pids=$(pgrep -f 'node .*onair\.js' | grep -v "^$$\$" | tr '\n' ' ')
  if [ -n "${pids// /}" ]; then
    echo "TRANSFER : RUNNING (pid $pids)"
  else
    echo "TRANSFER : not running"
  fi

  # 2. Anything of mine leaked and talking to the device? This has bitten twice:
  #    stray pollers contaminated two speed measurements before being noticed.
  local strays
  strays=$(ps -eo pid,args | grep -E 'watch2\.js|st\.js|push stat' | grep -v grep | wc -l)
  [ "$strays" -gt 0 ] && echo "WARNING  : $strays stray poller(s) on air — measurements suspect"

  # 3. OUTCOME, stated explicitly. "not running" alone is useless — it cannot
  #    distinguish finished-fine from died-silently, which is the exact question.
  if [ -f "$LOG" ]; then
    local held age
    held=$(grep -o 'held [0-9]*/[0-9]*' "$LOG" | tail -1)
    age=$(( $(date +%s) - $(stat -c %Y "$LOG" 2>/dev/null || echo 0) ))
    echo "STARTED  : $(head -2 "$LOG" | grep -o 'push [0-9]*' | head -1 >/dev/null && echo yes || echo 'no START seen') ($(stat -c %y "$LOG" 2>/dev/null | cut -d. -f1))"
    echo "PROGRESS : ${held:-none yet}"

    if grep -q 'MATCH \*\*\*' "$LOG"; then
      echo "OUTCOME  : *** SUCCESS *** — CRC verified"
      grep -E '^(held|bytes|CRC|elapsed|repairs)' "$LOG" | sed 's/^/           /'
    elif grep -q 'MISMATCH\|FAILED\|TIMEOUT' "$LOG"; then
      echo "OUTCOME  : *** FAILED ***"
      grep -E 'MISMATCH|FAILED|TIMEOUT' "$LOG" | tail -2 | sed 's/^/           /'
    elif [ -n "${pids// /}" ]; then
      echo "OUTCOME  : still in progress"
      [ "$age" -gt 60 ] && echo "         : !! no log activity for ${age}s — possible stall"
    else
      # The dangerous case: process gone, no verdict written. Say so loudly.
      echo "OUTCOME  : *** ENDED WITHOUT A RESULT *** (process gone, no CRC line)"
      echo "           last line: $(tail -1 "$LOG" | cut -c1-70)"
    fi
    # WHICH packets went missing. "repairs: 1" says a round happened; it does
    # not say what was lost, and that is the interesting part on a real link.
    local reps
    reps=$(grep -o 'push rep [0-9]* [0-9,]*' "$LOG" | sed 's/push rep [0-9]* //')
    if [ -n "$reps" ]; then
      echo "LOST/REQ : chunks re-requested by id —"
      echo "$reps" | while read -r r; do
        echo "           round: $r  ($(echo "$r" | tr ',' '\n' | wc -l) chunk(s))"
      done
    else
      echo "LOST/REQ : none — every chunk arrived first time"
    fi
    echo "LOG      : $LOG (updated ${age}s ago)"
  else
    echo "OUTCOME  : no log at $LOG — nothing has run"
  fi

  # 3b. WHERE IS THE IMAGE. Verified from the FILE, not from the log's word.
  echo "IMAGES   :"
  local found=0
  for f in /tmp/pid1-*.jpg; do
    [ -e "$f" ] || continue
    found=1
    python3 - "$f" <<'PY'
import sys,zlib,os
f=sys.argv[1]; d=open(f,'rb').read()
crc=zlib.crc32(d)&0xFFFFFFFF
ok='OK  ' if crc==0x65FBD5D9 and d[:2]==b'\xff\xd8' and d[-2:]==b'\xff\xd9' else 'BAD '
print(f'           {ok} {f}  {len(d)} bytes  crc 0x{crc:08X}  {"JPEG" if d[:2]==b"\xff\xd8" else "not JPEG"}')
side=f.replace('.jpg','.json')
if os.path.exists(side):
    import json
    m=json.load(open(side))
    lost=m.get('lostAndRerequested') or []
    lost=', '.join(lost) if lost else 'none'
    print('                transfer %ss | lost/re-requested: %s | repairs %s queries %s dupes %s'
          % (m.get('elapsedSec'), lost, m.get('repairRounds'), m.get('queries'), m.get('duplicateFrames')))
else:
    print('                transfer time UNKNOWN (saved before sidecars existed)')
PY
  done
  [ "$found" = 0 ] && echo "           (none saved)"

  # 4. Is the device alive? /nodes is cache-served and often has NO last_heard,
  #    which printed a confident-but-meaningless age. Listen PASSIVELY on the
  #    event stream instead: real frames or nothing. Still zero transmissions.
  node -e '
    const WebSocket=require("ws");
    const ws=new WebSocket("ws://'"$GW"'/events",{maxPayload:0});
    const seen={};let any=false;
    const t=setTimeout(()=>{
      if(!any) console.log("DEVICE   : SILENT for 8s (idle, or off — not proof of a hang)");
      process.exit(0);},8000);
    ws.on("error",()=>{console.log("DEVICE   : event stream unreachable");process.exit(0);});
    ws.on("message",m=>{let e;try{e=JSON.parse(m)}catch{return}
      const f=e.from_num; if(f!=='"$BENCH"'&&f!=='"$FIELD"')return;
      const who=f==='"$BENCH"'?"BENCH":"FIELD";
      const k=who+":"+e.type; if(seen[k])return; seen[k]=1; any=true;
      console.log(`DEVICE   : ${who} ALIVE — ${e.type}${e.portnum?" port "+e.portnum:""}`);
    });
  ' 2>/dev/null || echo "DEVICE   : (node/ws unavailable)"
  echo
}

if [ "$1" = "-w" ]; then
  while true; do snapshot; sleep 5; done
else
  snapshot
fi
