ALTER TABLE applicants
  ADD COLUMN mobile_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN applicants.mobile_verified_at IS
  'When the current mobile_number was verified by a server-validated OTP.';
