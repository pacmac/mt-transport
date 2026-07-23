// whatsapp notifier transport. Registered, empty — implement in its own phase.
'use strict';
const { ni } = require('../errors');
module.exports = (cfg) => ({
  name: 'whatsapp',
  async send(alert) { return ni('transports.whatsapp.send'); },
});
