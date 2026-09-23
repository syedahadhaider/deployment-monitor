-- The monitored endpoints. These must exist before any check can be written:
-- the ingest validator rejects a target_id it does not already know, so a
-- payload can never introduce a target by naming one.
--
-- Keep these ids identical to collector/targets.toml. An id is permanent once
-- it has recorded checks - renaming one orphans its history.

INSERT OR IGNORE INTO targets (id, name, url, enabled) VALUES
  ('portfolio',         'Portfolio',        'https://syedahadhaider.com/',          1),
  ('ash-orbit',         'Ash & Orbit',      'https://ash-orbit.vercel.app/',        1),
  ('hearth-and-hollow', 'Hearth & Hollow',  'https://hearthnhollow.vercel.app/',    1),
  ('plinth',            'PLINTH',           'https://plinth-blush.vercel.app/',     1),
  ('shynx-store',       'Shynx Store',      'https://shynx-store.vercel.app/',      1),
  ('custom',            'Custom',           'https://custom-cyan.vercel.app/',      1),
  ('material-studies',  'Material Studies', 'https://material-studies.vercel.app/', 1),
  ('form-after',        'FORM / AFTER',     'https://form-after.vercel.app/',       1);
