const db = require('../db');
const redis = require('../redis');

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function calculateDuration(startMin, endMin) {
  if (startMin === endMin) return 1440; // 24h shift
  if (endMin > startMin) return endMin - startMin;
  return (1440 - startMin) + endMin; // night shift
}

exports.dashboard = async (plant_id) => {

  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 8);

  /* ================= SHIFT ================= */

  const { rows: shiftRows } = await db.query(`
    SELECT id, shift_code, start_time, end_time, break_minutes
    FROM shifts
    WHERE plant_id = $1
      AND (
        (start_time <= end_time AND $2 BETWEEN start_time AND end_time)
        OR
        (start_time > end_time AND ($2 >= start_time OR $2 <= end_time))
      )
      AND is_active = TRUE
    LIMIT 1
  `, [plant_id, currentTime]);

  const shift = shiftRows[0];

  if (!shift) {
    return {
      shift: null,
      summary: { total: 0, running: 0, idle: 0 },
      machines: []
    };
  }

  /* ================= SHIFT TIME ================= */

  const today = now.toISOString().split('T')[0];
  let shiftStart;

  if (shift.start_time <= shift.end_time) {
    shiftStart = new Date(`${today}T${shift.start_time}`);
  } else {
    if (currentTime >= shift.start_time) {
      shiftStart = new Date(`${today}T${shift.start_time}`);
    } else {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      shiftStart = new Date(`${y.toISOString().split('T')[0]}T${shift.start_time}`);
    }
  }

  const startMin = timeToMinutes(shift.start_time);
  const endMin = timeToMinutes(shift.end_time);
  const shiftDurationMinutes = calculateDuration(startMin, endMin);

  const shiftEnd = new Date(shiftStart);
  shiftEnd.setMinutes(shiftEnd.getMinutes() + shiftDurationMinutes);

  const effectiveNow = now > shiftEnd ? shiftEnd : now;

  const shiftElapsedMinutes =
    Math.max(0, Math.floor((effectiveNow - shiftStart) / 60000));

  const plannedMinutes =
    Math.max(0, shiftDurationMinutes - Number(shift.break_minutes || 0));

  /* ================= MACHINES ================= */

  const { rows: machines } = await db.query(`
    SELECT id, machine_serial_no, image_url
    FROM machines
    WHERE plant_id = $1
      AND is_active = TRUE
    ORDER BY id
  `, [plant_id]);

  const machineIds = machines.map(m => m.id);

  if (!machineIds.length) {
    return {
      shift: {
        shift_code: shift.shift_code,
        shiftElapsedMinutes,
        plannedMinutes
      },
      summary: { total: 0, running: 0, idle: 0 },
      machines: []
    };
  }

  /* ================= PRODUCTION ================= */

  const { rows: prodRows } = await db.query(`
    SELECT machine_id,
           SUM(run_minutes) AS run_minutes,
           SUM(idle_minutes) AS idle_minutes,
           SUM(produced_qty) AS produced_qty
    FROM production_hourly
    WHERE machine_id = ANY($1)
      AND hour_start >= $2
      AND hour_start <= $3
    GROUP BY machine_id
  `, [machineIds, shiftStart, effectiveNow]);

  const prodMap = {};

  prodRows.forEach(r => {
    prodMap[r.machine_id] = {
      run_minutes: Number(r.run_minutes || 0),
      idle_minutes: Number(r.idle_minutes || 0),
      produced_qty: Number(r.produced_qty || 0)
    };
  });

  /* ================= COMPONENT TARGETS ================= */

  const { rows: componentRows } = await db.query(`
  SELECT
    machine_id,
    target
  FROM components
  WHERE machine_id = ANY($1)
    AND CURRENT_DATE BETWEEN from_date AND to_date
`, [machineIds]);

  const componentMap = {};

  componentRows.forEach(r => {
    componentMap[r.machine_id] = r;
  });


  /* ================= LIVE STATUS (DB ONLY) ================= */

  const { rows: liveRows } = await db.query(`
    SELECT DISTINCT ON (machine_id)
           machine_id,
           machine_status,
           alarm,
           received_at,
           parts_count
    FROM telemetry_raw
    WHERE machine_id = ANY($1)
    ORDER BY machine_id, received_at DESC
  `, [machineIds]);

  const liveMap = {};
  liveRows.forEach(r => liveMap[r.machine_id] = r);

  /* ================= BUILD RESPONSE ================= */

  let total = 0;
  let running = 0;
  let idle = 0;

  const machinesList = [];

  for (const m of machines) {

    const live = liveMap[m.id] || {};
    const prod = prodMap[m.id] || {};

    const rawStatus = (live.machine_status || '').toUpperCase();
    const alarm = live.alarm === true;

    let status = 'IDLE';

    if (['RUN', 'RUNNING', 'CUTTING'].includes(rawStatus)) {
      status = 'RUNNING';
      running++;
    } else {
      idle++;
    }

    total++;

    let run = prod.run_minutes || 0;

    if (run > shiftElapsedMinutes) {
      run = shiftElapsedMinutes;
    }

    let plannedElapsedMinutes =
      Math.max(0, shiftElapsedMinutes - Number(shift.break_minutes || 0));

    if (run > plannedElapsedMinutes) {
      run = plannedElapsedMinutes;
    }

    let idleMinutes = prod.idle_minutes || 0;

    if (idleMinutes < 0) idleMinutes = 0;

    const utilization =
      plannedMinutes > 0
        ? Number(((run * 100) / plannedMinutes).toFixed(2))
        : 0;

    machinesList.push({
      machine_id: m.id,
      machine_serial_no: m.machine_serial_no,
      image_url: m.image_url,
      status,
      alarm,
      run_minutes: run,
      idle_minutes: idleMinutes,
      produced_qty: prod.produced_qty || 0,
      utilization,
      target_qty: componentMap[m.id]?.target || 0,
  achieved_qty: live?.parts_count || 0

    });
  }

  /* ================= RESPONSE ================= */

  return {
    shift: {
      shift_code: shift.shift_code,
      shiftElapsedMinutes,
      plannedMinutes
    },
    summary: { total, running, idle },
    machines: machinesList
  };
};



exports.machineDetail = async (plantId, machineId) => {

  try {

    /* ================= MACHINE ================= */

    const { rows: machineRows } = await db.query(`
      SELECT id, machine_serial_no, image_url
      FROM machines
      WHERE id = $1 AND plant_id = $2
    `, [machineId, plantId]);

    if (!machineRows.length) return null;

    const machine = machineRows[0];


    /* ================= CURRENT SHIFT ================= */

    const { rows: shiftRows } = await db.query(`
      SELECT shift_code, start_time, end_time
      FROM shifts
      WHERE plant_id = $1
        AND is_active = true
        AND (
          (start_time <= end_time AND
           CURRENT_TIME BETWEEN start_time AND end_time)
          OR
          (start_time > end_time AND
           (CURRENT_TIME >= start_time OR CURRENT_TIME <= end_time))
        )
      LIMIT 1
    `, [plantId]);

    const shift = shiftRows[0] || null;


    /* ================= OPERATOR ================= */

    const { rows: operatorRows } = await db.query(`
      SELECT o.operator_name
      FROM operator_machine_assignments a
      JOIN operators o
        ON o.id = a.operator_id
      WHERE a.machine_id = $1
        AND a.is_active = TRUE
      LIMIT 1
    `, [machineId]);

    const operator = operatorRows[0] || null;


    /* ================= COMPONENT ================= */

    const { rows: componentRows } = await db.query(`
      SELECT
        part_name,
        part_number,
        cycle_time,
        target
      FROM components
      WHERE machine_id = $1
        AND CURRENT_DATE BETWEEN from_date AND to_date
      ORDER BY created_at DESC
      LIMIT 1
    `, [machineId]);

    const component = componentRows[0] || null;




    /* ================= PRODUCTION ================= */

    const { rows: timeRows } = await db.query(`
      SELECT
        SUM(run_minutes) AS run_minutes,
        SUM(idle_minutes) AS idle_minutes,
        SUM(off_minutes) AS off_minutes
      FROM production_hourly
      WHERE machine_id = $1
        AND hour_start >= now() - interval '8 hours'
    `, [machineId]);

    const timeInfo = timeRows[0] || {};


    /* ================= QUALITY ================= */

    const { rows: qualityRows } = await db.query(`
      SELECT
        SUM(total_qty) AS accepted,
        SUM(reject_qty) AS rejected
      FROM quality_entries
      WHERE machine_id = $1
        AND created_at >= now() - interval '8 hours'
    `, [machineId]);

    const quality = qualityRows[0] || {};


    /* ================= OEE ================= */

    const { rows: oeeRows } = await db.query(`
      SELECT availability, performance, quality, oee
      FROM oee_shift_summary
      WHERE machine_id = $1
      ORDER BY shift_date DESC
      LIMIT 1
    `, [machineId]);

    const oee = oeeRows[0] || {};


    /* ================= LIVE ================= */

    const { rows: liveRows } = await db.query(`
      SELECT machine_status, rpm, feed_rate, parts_count
      FROM telemetry_raw
      WHERE machine_id = $1
      ORDER BY received_at DESC
      LIMIT 1
    `, [machineId]);

    const live = liveRows[0] || {};


    /* ================= RESPONSE ================= */

    return {

      machine: {
        id: machine.id,
        name: machine.machine_serial_no,
        image: machine.image_url
      },

      shift: {
        shift_code: shift?.shift_code || '--'
      },

      operator: {
        operator_name: operator?.operator_name || '--'
      },

      job: {
        part_name: component?.part_name || '--',
        component_id: component?.part_number || '--',
        target_qty: component?.target || 0,
        achieved_qty: live?.parts_count || 0,
        cycle_time: component?.cycle_time || null
      },

      production: {
        run_minutes: Number(timeInfo.run_minutes || 0),
        idle_minutes: Number(timeInfo.idle_minutes || 0),
        off_minutes: Number(timeInfo.off_minutes || 0)
      },

      quality: {
        accepted: Number(quality.accepted || 0),
        rejected: Number(quality.rejected || 0)
      },

      oee: {
        availability: Number(oee.availability || 0),
        performance: Number(oee.performance || 0),
        quality: Number(oee.quality || 0),
        oee: Number(oee.oee || 0)
      },

      live: {
        machine_status: live?.machine_status || 'UNKNOWN',
        rpm: live?.rpm || 0,
        feed_rate: live?.feed_rate || 0,
        parts_count: live?.parts_count || 0
      }

    };

  } catch (err) {

    console.error("Machine detail service error:", err);
    throw err;

  }

};