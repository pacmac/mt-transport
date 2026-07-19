# Site geometry — garage ↔ house

**Settled 2026-07-19. Do not re-derive. Do not quote 101° or 111° — both were
circulating and both are wrong.**

| | |
|---|---|
| **House → garage bearing** | **121.2°**  (south-east) |
| **Garage → house bearing** | **301.2°**  (north-west) |
| **Distance** | **2.501 km** |

**The garage lies SOUTH and EAST of the house.** That sentence is the check:
121° is SE, so it can only be the house→garage direction. An earlier revision of
this file had the two swapped — state the compass sense, not just the number.

## DO NOT AIM THE ANTENNA BY THIS BEARING

The geometric bearing is **not** the best aim. Measured 2026-07-19:

| antenna aim | error vs geometric 301.2° | measured SNR |
|---|---|---|
| ~312° (before the swap) | 10.8° off | **−5.0 dB** |
| ~300° (after the swap) | 1.2° off | **−17.2 dB** |

Aiming it *more* accurately by geometry made it **12 dB worse**. At 2.5 km over
terrain the strongest path is often not the direct line — diffraction or a
reflection can put the optimum well off the geometric bearing. **312° is
empirically validated; 301.2° is only arithmetic.**

Note also that 12° of aim error on a ~12 dBi Yagi is worth roughly **1 dB**, not
12 — so most of that loss is something else (connector, pigtail, a different
antenna arriving with the swapped unit). Aim by measurement, and check the RF
connection before blaming direction.

A live peaking readout is at `scratchpad/peak_antenna.py` — prints SNR with a
bar every time the gateway hears the unit.

## Check the radar table first

`http://192.168.10.205:8000/radar` lists `HOME 121° 2.5km` and shows its centre
as `51.0263, -3.1588`. The radar is centred at the HOUSE, so the 121° it shows
is **house → garage**. It computes this continuously from live position data.

**That is the authoritative source and it should be the first thing consulted.**
On 2026-07-19 this bearing was laboriously re-derived from raw coordinates while
the answer was already on screen. Look at the radar.

## The two points

| point | coordinate | source |
|---|---|---|
| **garage** | 51.014683105884586, −3.1282490088769843 | `pac-garage-alarm/include/secrets.h` → `MESH_UNITS`. Peter: *"the EXACT location +/- 0.5 meters"* |
| **house** | 51.0263296, −3.1588352 | gateway `GET /home_pos`, and the radar's plotted centre |

## Why the wrong bearings kept appearing

`MESH_UNITS` contains the **same coordinate in both rows**:

```c
{0x987ab80f, "Alarm Home",     "HOME", 51.014683105884586, -3.1282490088769843, 3200},
{0x8cee336b, "Alarm Deployed", "DEPL", 51.014683105884586, -3.1282490088769843, 3200},
```

Identical to sixteen decimal places — one value pasted twice. Anything deriving
a bearing from what the *units broadcast* therefore gets the garage coordinate
for both nodes and cannot produce a meaningful answer at all. Logged as **BUG 18**
in the `bugs-enhancements` task.

Note also that the row holding the garage coordinate is labelled `"Alarm Home"`,
which is actively misleading — identity in `MESH_UNITS` follows the **board**
(keyed by `nodeNum`), not the **site**. After the 2026-07-19 unit swap the board
sitting at the garage is the one named `HOME`.

## Precision, and why the disagreement was so large

At 2.5 km:

| | |
|---|---|
| 1° of bearing | **44 m** sideways |
| the 101 vs 121 spread | **880 m** |
| the stated ±0.5 m position accuracy | **0.01°** — negligible |

So the position precision was never the problem. A 10–20° spread means the
calculations used endpoints hundreds of metres apart — i.e. a *different second
point*, almost certainly the duplicated row.

**Explicitly ruled out** as explanations, none of which can produce 10°+:

| candidate | magnitude here |
|---|---|
| UK magnetic declination (2026, Somerset) | ~1° |
| OS grid convergence at −3.13° lon | ~0.9° |
| great-circle vs rhumb line at 2.5 km | <0.001° |

## Why it matters

The link runs at roughly **0.3 dB above the SF11 demodulation floor**
(−17.2 dB SNR measured 2026-07-19, against a limit near −17.5 dB) — with no
margin to spare.

But note the section above: aiming by this bearing is what *produced* that
figure. The number here is for distance, geometry and sanity-checking the map.
**Aim by measurement.**
