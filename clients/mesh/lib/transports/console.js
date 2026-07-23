// console notifier transport (the reference/simplest). Skeleton: send() stub.
'use strict';
const { ni } = require('../errors');
// factory(cfg) -> transport. Common interface: async send(alert).
module.exports = (cfg) => ({
  name: 'console',
  async send(alert) { return ni('transports.console.send'); },
});
