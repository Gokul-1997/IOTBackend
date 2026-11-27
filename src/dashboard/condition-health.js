/* A transparent condition index, not a predicted probability of failure.
 * Only explicit, finite controller readings participate. Missing checks do
 * not become healthy zeros. An active machine alarm is a blocking failure. */
const numeric = value => value !== null && value !== undefined && value !== '' &&
  typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;

function conditionHealth(row, nowMs = Date.now()) {
  if (!row) return null;
  const observed = row.received_at == null ? NaN : new Date(row.received_at).getTime();
  if (!Number.isFinite(observed) || observed > nowMs) return null;
  const checks = [];
  const add = (label, score) => checks.push({ label, score, band: score === 100 ? 'Healthy' : score === 50 ? 'Normal' : 'Critical' });
  const high = (key, label, warning, critical, zeroValid = true) => {
    const value = numeric(row[key]);
    if (value !== null && (zeroValid ? value >= 0 : value > 0)) add(label, value >= critical ? 0 : value >= warning ? 50 : 100);
  };
  const low = (key, label) => {
    const value = numeric(row[key]);
    if (value !== null && value >= 0) add(label, value < 10 ? 0 : value < 100 ? 50 : 100);
  };
  high('spindle_load', 'Spindle load', 60, 80);
  high('spindle_motor_temp', 'Spindle temperature', 60, 80, false);
  low('spindle_insulation_res', 'Spindle insulation resistance');
  for (const axis of ['x', 'y', 'z']) {
    high(`servo_load_${axis}`, `Servo ${axis.toUpperCase()} load`, 60, 80);
    high(`servo_temp_${axis}`, `Servo ${axis.toUpperCase()} temperature`, 60, 80, false);
    high(`encoder_temp_${axis}`, `Encoder ${axis.toUpperCase()} temperature`, 60, 80, false);
    low(`servo_insulation_res_${axis}`, `Servo ${axis.toUpperCase()} insulation resistance`);
  }
  const fans = row.fan_status;
  if (fans && typeof fans === 'object' && !Array.isArray(fans)) {
    for (const [name, fan] of Object.entries(fans)) {
      if (fan && typeof fan === 'object' && !Array.isArray(fan)) {
        if (fan.fault === true) add(name, 0);
        else if (fan.on === false || (numeric(fan.rpm) === 0 && fan.on === true)) add(name, 50);
        else if (fan.on === true || (numeric(fan.rpm) > 0 && fan.fault === false)) add(name, 100);
      } else if (typeof fan === 'boolean') add(name, fan ? 100 : 0);
    }
  }
  if (row.battery_supported !== false) {
    const axes = row.acc_battery_status ?? row.apc_battery_status;
    if (axes && typeof axes === 'object' && !Array.isArray(axes)) {
      for (const [axis, battery] of Object.entries(axes)) {
        if (typeof battery === 'boolean') add(`ACC ${axis} battery`, battery ? 50 : 100);
        else if (battery && typeof battery === 'object') {
          const flags = ['ABP', 'INP', 'EXP'].map(key => battery[key]);
          if (battery.low === true || flags.includes(true)) add(`ACC ${axis} battery`, 50);
          else if (battery.low === false || flags.every(value => value === false)) add(`ACC ${axis} battery`, 100);
        }
      }
    }
    const warning = row.cnc_battery_warning?.warning;
    if (typeof warning === 'boolean') add('CNC battery', warning ? 50 : 100);
  }
  const alarm = row.alarm === true || ['ALARM', 'EMERGENCY', 'BREAKDOWN'].includes(String(row.machine_status).toUpperCase());
  if (alarm) add('Active machine alarm', 0);
  if (!checks.length) return null;
  const mean = Math.round(checks.reduce((sum, check) => sum + check.score, 0) / checks.length);
  const score = alarm ? 0 : checks.some(check => check.score === 0) ? Math.min(69, mean) : mean;
  return {
    score, status: score >= 70 ? 'Good' : 'Bad', threshold: 70,
    observed_at: new Date(observed).toISOString(), stale: nowMs - observed > 60_000,
    reported_checks: checks.length, checks,
    basis: 'Mean of reported checks: healthy 100, normal 50, critical 0. Any critical check caps the score below 70. An active machine alarm sets the score to 0. Missing checks and zero temperature placeholders are excluded.'
  };
}

module.exports = { conditionHealth };
