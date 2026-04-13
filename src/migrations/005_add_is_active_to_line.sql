-- Add is_active column to line table (if not exists)
ALTER TABLE line
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Create index for active status queries
CREATE INDEX IF NOT EXISTS idx_line_is_active ON line(is_active);
