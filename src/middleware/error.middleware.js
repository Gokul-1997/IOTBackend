module.exports = (err, req, res, next) => {
  console.error(err);

  res.status(err.status || 500).json({
    status: 'error',
    message: err.message || 'Internal Server Error'
  });
};
