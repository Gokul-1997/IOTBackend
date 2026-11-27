exports.validateCreate = data => {
  if (!data.operator_code) throw { status: 400, message: 'Operator code required' };
  if (!data.operator_name) throw { status: 400, message: 'Operator name required' };
  if (!data.shift_id) throw { status: 400, message: 'Shift is required' };
};

exports.normalizeOptionalDetails = data => {
  const normalized = { ...data };
  if (Object.hasOwn(data, 'phone_number')) {
    const phone = data.phone_number;
    if (phone != null && typeof phone !== 'string') throw { status: 400, message: 'Phone number must be text' };
    const value = phone?.trim() || null;
    if (value && (value.length > 30 || !/^\+?[0-9][0-9 ()-]{5,29}$/.test(value))) {
      throw { status: 400, message: 'Enter a valid phone number or leave it blank' };
    }
    normalized.phone_number = value;
  }
  if (Object.hasOwn(data, 'date_of_birth')) {
    const dob = data.date_of_birth;
    if (dob != null && typeof dob !== 'string') throw { status: 400, message: 'Date of birth must use YYYY-MM-DD' };
    const value = dob?.trim() || null;
    if (value) {
      const date = new Date(value + 'T00:00:00Z');
      const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-') || !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 10) !== value || value > today) {
        throw { status: 400, message: 'Enter a valid birth date that is not in the future' };
      }
    }
    normalized.date_of_birth = value;
  }
  return normalized;
};
