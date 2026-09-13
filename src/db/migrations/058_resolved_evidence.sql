-- What evidence a request required, decided once when its mode was resolved.
-- 'all': every candidate needs each of the resolved mode's sources (a mixed
--        question needs footage AND its aligned transcript).
-- 'any': the sources are searched together and either may establish a moment
--        (an undetermined question, or a quoted phrase that may be spoken or
--        on screen). Only meaningful with resolved_mode = 'both'.
ALTER TABLE clip_requests
  ADD COLUMN IF NOT EXISTS resolved_evidence TEXT
  CHECK (resolved_evidence IS NULL OR resolved_evidence IN ('all', 'any'));
