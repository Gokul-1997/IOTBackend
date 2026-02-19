const bcrypt = require('bcrypt');

exports.hash = pwd => bcrypt.hash(pwd, 10);
exports.compare = (pwd, hash) => bcrypt.compare(pwd, hash);
