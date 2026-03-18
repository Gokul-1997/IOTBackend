/**
 * OEE REPORTS SERVICE - FIXED
 * Backend service for OEE data with filtering and pagination
 */

const db = require('../db');

/* ===============================================
   GET META (Machines, Shifts, Lines)
   =============================================== */
exports.getMeta = async (plantId) => {

  try {

    if (!plantId) {
      throw new Error('Plant ID is required');
    }

    console.log(`📊 Loading OEE meta for plant ${plantId}`);

    // ✅ Get LINES (from line table, joined with plant)
    const linesQuery = await db.query(`
      SELECT DISTINCT
        l.id,
        l.name
      FROM line l
      WHERE l.plant_id = $1
      ORDER BY l.name ASC
    `, [plantId]);

    console.log(`✅ Loaded ${linesQuery.rows.length} lines`);

    // ✅ Get MACHINES (with machine_serial_no)
    const machinesQuery = await db.query(`
      SELECT 
        m.id,
        m.machine_serial_no,
        l.id as line_id
      FROM machines m
      LEFT JOIN line l ON m.plant_id = l.plant_id
      WHERE m.plant_id = $1 AND m.is_active = TRUE
      ORDER BY m.machine_serial_no ASC
    `, [plantId]);

    console.log(`✅ Loaded ${machinesQuery.rows.length} machines`);

    // ✅ Get SHIFTS (with shift details)
    const shiftsQuery = await db.query(`
      SELECT 
        s.id,
        s.shift_code,
        s.shift_name,
        s.start_time,
        s.end_time
      FROM shifts s
      WHERE s.plant_id = $1 AND s.is_active = TRUE
      ORDER BY s.start_time ASC
    `, [plantId]);

    console.log(`✅ Loaded ${shiftsQuery.rows.length} shifts`);

    return {
      lines: linesQuery.rows,
      machines: machinesQuery.rows,
      shifts: shiftsQuery.rows
    };

  } catch (err) {
    console.error('❌ getMeta error:', err.message);
    throw err;
  }

};

/* ===============================================
   GET REPORTS (With filters and pagination)
   =============================================== */
exports.getReports = async (query, plantId) => {

  try {

    const {
      line_id,
      machine_id,
      shift_id,
      from_date,
      to_date,
      page = 1,
      limit = 6,
      search,
      sort_by = 'shift_date',
      sort_order = 'DESC'
    } = query;

    console.log(`\n📊 Fetching OEE reports for plant ${plantId}`);
    console.log(`   Filters: machine=${machine_id}, shift=${shift_id}, line=${line_id}`);

    // Validate pagination
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, parseInt(limit) || 6);
    const offset = (pageNum - 1) * limitNum;

    // Validate sort
    const allowedSortColumns = [
      'shift_date',
      'machine_serial_no',
      'oee',
      'availability',
      'performance',
      'quality'
    ];
    const sortColumn = allowedSortColumns.includes(sort_by) ? sort_by : 'shift_date';
    const sortDir = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    /* ===============================
       BUILD DYNAMIC WHERE CLAUSE
    ================================ */
    const where = [];
    const params = [];
    let paramIndex = 1;

    // Plant filter (ALWAYS)
    where.push(`m.plant_id = $${paramIndex++}`);
    params.push(plantId);

    // Line filter (optional)
    if (line_id && line_id !== 'null' && line_id !== '') {
      where.push(`l.id = $${paramIndex++}`);
      params.push(parseInt(line_id));
    }

    // Machine filter (optional)
    if (machine_id && machine_id !== 'null' && machine_id !== '') {
      where.push(`os.machine_id = $${paramIndex++}`);
      params.push(parseInt(machine_id));
    }

    // Shift filter (optional)
    if (shift_id && shift_id !== 'null' && shift_id !== '') {
      where.push(`os.shift_id = $${paramIndex++}`);
      params.push(parseInt(shift_id));
    }

    // Date range filter (optional)
    if (from_date && from_date !== '' && to_date && to_date !== '') {
      where.push(`os.shift_date BETWEEN $${paramIndex++} AND $${paramIndex++}`);
      params.push(from_date, to_date);
    }

    // Search filter (optional)
    if (search && search !== '') {
      where.push(`(
        LOWER(m.machine_serial_no) LIKE LOWER($${paramIndex++})
        OR LOWER(s.shift_code) LIKE LOWER($${paramIndex++})
      )`);
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    /* ===============================
       COUNT TOTAL RECORDS
    ================================ */
    const countQuery = `
      SELECT COUNT(*) as total
      FROM oee_shift_summary os
      JOIN machines m ON m.id = os.machine_id
      LEFT JOIN line l ON m.plant_id = l.plant_id
      JOIN shifts s ON s.id = os.shift_id
      ${whereClause}
    `;

    console.log('📋 Executing count query...');
    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total || 0);

    console.log(`✅ Total records: ${total}`);

    /* ===============================
       GET PAGINATED DATA
    ================================ */
    const dataQuery = `
      SELECT
        os.shift_date,
        m.id as machine_id,
        m.machine_serial_no,
        s.shift_code,
        s.shift_name,
        (
          SELECT DISTINCT o.operator_name
          FROM operators o
          JOIN operator_machine_assignments oma ON o.id = oma.operator_id
          WHERE oma.machine_id = m.id
          AND oma.is_active = TRUE
          LIMIT 1
        ) as operator_name,
        ROUND(CAST(os.oee AS NUMERIC), 2) as oee,
        ROUND(CAST(os.availability AS NUMERIC), 2) as availability,
        ROUND(CAST(os.performance AS NUMERIC), 2) as performance,
        ROUND(CAST(os.quality AS NUMERIC), 2) as quality
      FROM oee_shift_summary os
      JOIN machines m ON m.id = os.machine_id
      LEFT JOIN line l ON m.plant_id = l.plant_id
      JOIN shifts s ON s.id = os.shift_id
      ${whereClause}
      ORDER BY ${sortColumn === 'machine_serial_no' ? 'm.' : 'os.'}${sortColumn} ${sortDir}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    params.push(limitNum, offset);

    console.log('📋 Executing data query...');
    const dataResult = await db.query(dataQuery, params);

    console.log(`✅ Fetched ${dataResult.rows.length} records`);

    return {
      data: dataResult.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      },
      filters: {
        line_id,
        machine_id,
        shift_id,
        from_date,
        to_date,
        search
      }
    };

  } catch (err) {
    console.error('❌ getReports error:', err.message);
    console.error(err.stack);
    throw err;
  }

};

/* ===============================================
   EXPORT TO CSV
   =============================================== */
exports.exportCSV = async (query, plantId) => {

  try {

    const { line_id, machine_id, shift_id, from_date, to_date, search } = query;

    const where = [];
    const params = [];
    let paramIndex = 1;

    where.push(`m.plant_id = $${paramIndex++}`);
    params.push(plantId);

    if (line_id && line_id !== 'null') {
      where.push(`l.id = $${paramIndex++}`);
      params.push(parseInt(line_id));
    }

    if (machine_id && machine_id !== 'null') {
      where.push(`os.machine_id = $${paramIndex++}`);
      params.push(parseInt(machine_id));
    }

    if (shift_id && shift_id !== 'null') {
      where.push(`os.shift_id = $${paramIndex++}`);
      params.push(parseInt(shift_id));
    }

    if (from_date && to_date) {
      where.push(`os.shift_date BETWEEN $${paramIndex++} AND $${paramIndex++}`);
      params.push(from_date, to_date);
    }

    if (search && search !== '') {
      where.push(`(LOWER(m.machine_serial_no) LIKE LOWER($${paramIndex++}))`);
      params.push(`%${search}%`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const query_sql = `
      SELECT
        os.shift_date,
        m.machine_serial_no,
        s.shift_code,
        (
          SELECT o.operator_name
          FROM operators o
          JOIN operator_machine_assignments oma ON o.id = oma.operator_id
          WHERE oma.machine_id = m.id AND oma.is_active = TRUE
          LIMIT 1
        ) as operator_name,
        os.oee,
        os.availability,
        os.performance,
        os.quality
      FROM oee_shift_summary os
      JOIN machines m ON m.id = os.machine_id
      LEFT JOIN line l ON m.plant_id = l.plant_id
      JOIN shifts s ON s.id = os.shift_id
      ${whereClause}
      ORDER BY os.shift_date DESC
    `;

    const result = await db.query(query_sql, params);

    return {
      data: result.rows,
      filename: `oee_report_${new Date().toISOString().split('T')[0]}.csv`
    };

  } catch (err) {
    console.error('❌ exportCSV error:', err.message);
    throw err;
  }

};