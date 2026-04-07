-- Add is_admin column to users table
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- Ensure the first user remains the admin
UPDATE users SET is_admin = 1 WHERE id = 1;
