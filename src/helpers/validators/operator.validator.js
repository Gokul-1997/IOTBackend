exports.validateCreate = data => {
  if (!data.operator_code) throw { status: 400, message: 'Operator code required' };
  if (!data.operator_name) throw { status: 400, message: 'Operator name required' };
  if (!data.shift_id) throw { status: 400, message: 'Shift is required' };
};
