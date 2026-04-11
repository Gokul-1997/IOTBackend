const db = require('../db');

/**
 * Middleware factory: check that the user's company plan allows a feature page.
 *
 * Usage:
 *   router.get('/machines', auth, checkPlan('page:machines'), ctrl.list)
 *
 * S&T Super users bypass plan checks entirely.
 */
module.exports = function checkPlan(featureKey) {
  return async (req, res, next) => {
    try {
      // SNT_SUPER bypasses all plan gates
      if (req.user.is_snt_super) return next();

      const company_id = req.user.company_id;
      if (!company_id) {
        return res.status(403).json({ message: 'No company assigned to this user' });
      }

      const { rows } = await db.query(
        `SELECT pf.is_enabled
         FROM company_plans cp
         JOIN plan_features pf ON pf.plan_id = cp.plan_id
         WHERE cp.company_id = $1 AND cp.is_active = true AND pf.feature_key = $2`,
        [company_id, featureKey]
      );

      if (!rows.length || !rows[0].is_enabled) {
        return res.status(403).json({
          message: `Feature '${featureKey}' is not available on your current plan`,
          upgrade_required: true
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};
