-- Retain the additive company column and nullable measurement representation.
-- Application rollback is compatible; forcing unknown measurements to zero or
-- dropping company ownership would destroy their meaning. No destructive undo.
SELECT '044 schema retained for safe application rollback' AS status;
