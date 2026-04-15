const db = require('../db');

/**
 * Quota middleware factory.
 * Checks company plan limits before create operations.
 *
 * Usage:
 *   router.post('/', auth, checkQuota('plants'), controller.createPlant)
 *   router.post('/', auth, checkQuota('machines'), controller.createMachine)
 *   router.post('/', auth, checkQuota('users'), controller.createUser)
 *
 * SNT_SUPER bypasses all quota checks.
 */
module.exports = function checkQuota(resource) {
  return async (req, res, next) => {
    try {
      if (req.user.is_snt_super) return next();

      const company_id = req.user.company_id;
      if (!company_id) {
        return res.status(403).json({ message: 'No company assigned to this user' });
      }

      // Get plan limits (company_plans override takes priority over plan defaults)
      const { rows: planRows } = await db.query(
        `SELECT
           COALESCE(cp.max_plants,   p.max_plants)   AS max_plants,
           COALESCE(cp.max_machines, p.max_machines) AS max_machines,
           COALESCE(cp.max_users,    p.max_users)    AS max_users
         FROM company_plans cp
         JOIN plans p ON p.id = cp.plan_id
         WHERE cp.company_id = $1 AND cp.is_active = true`,
        [company_id]
      );

      if (!planRows.length) {
        return res.status(403).json({ message: 'No active plan found for your company. Contact your administrator.' });
      }

      const limits = planRows[0];
      const maxKey = `max_${resource}`;
      const limit  = Number(limits[maxKey]);

      if (!limit || limit <= 0) return next(); // unlimited

      // Count current active records
      const tableMap = { plants: 'plants', machines: 'machines', users: 'users' };
      const table    = tableMap[resource];
      if (!table) return next();

      const { rows: countRows } = await db.query(
        `SELECT COUNT(*) FROM ${table} WHERE company_id = $1 AND is_active = true`,
        [company_id]
      );

      const current = Number(countRows[0].count);

      if (current >= limit) {
        return res.status(403).json({
          message: `Your plan allows a maximum of ${limit} ${resource}. You currently have ${current}. Please upgrade your plan or contact your administrator.`,
          quota_exceeded: true,
          resource,
          current,
          limit
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};
