// email notifier transport. Registered, empty — implement in its own phase.
'use strict';
const { ni } = require('../errors');
module.exports = (cfg) => ({
  name: 'email',
  async send(alert) { return ni('transports.email.send'); },
});
