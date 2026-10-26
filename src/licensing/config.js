'use strict';

function mode(env = process.env) {
  const value = env.DEPLOYMENT_MODE || 'cloud';
  if (!['cloud', 'on_prem'].includes(value)) throw new Error('DEPLOYMENT_MODE must be cloud or on_prem');
  return value;
}

// An installed on-prem release must never have a flag which bypasses its license.
function enabled(env = process.env) {
  return mode(env) === 'on_prem' || env.PHASE3_LICENSING_ENABLED === 'true';
}

module.exports = {
  mode,
  enabled,
  signingKeyFile: (env = process.env) => env.LICENSE_SIGNING_KEY_FILE || null,
  verifyKeyFile: (env = process.env) => env.LICENSE_VERIFY_KEY_FILE || null,
};
