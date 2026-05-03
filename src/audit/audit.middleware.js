const auditService = require('./audit.service');

module.exports = function auditLog(action, resource) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function(body) {
      if (res.statusCode < 400 && req.user) {
        auditService.log({
          user_id:     req.user.id,
          company_id:  req.user.company_id,
          action,
          resource,
          resource_id: req.params.id || body?.data?.id || null,
          new_value:   ['POST','PUT','PATCH'].includes(req.method) ? req.body : null,
          ip_address:  req.ip,
          user_agent:  req.headers['user-agent']
        }).catch(() => {});
      }
      return originalJson(body);
    };
    next();
  };
};
