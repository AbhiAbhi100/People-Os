// Multi-tenant schema. Every business row carries company_id; every query filters on it.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text NOT NULL,
  access text NOT NULL DEFAULT 'employee' CHECK (access IN ('employee', 'manager', 'hr')),
  password_hash text,
  department text, title text, level text, location text,
  manager_id uuid REFERENCES people(id) ON DELETE SET NULL,
  join_date date,
  status text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Exited')),
  exit_date date, exit_reason text,
  gender text, salary_lpa numeric, performance_rating int, engagement_score int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS people_email_uq ON people (lower(email));
CREATE INDEX IF NOT EXISTS people_company_idx ON people (company_id);
CREATE INDEX IF NOT EXISTS people_manager_idx ON people (manager_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token_hash text PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE IF NOT EXISTS leave_balances (
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  leave_type text NOT NULL,
  balance numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, leave_type)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  leave_type text NOT NULL,
  start_date date NOT NULL, end_date date NOT NULL, days numeric NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
  decided_by uuid REFERENCES people(id) ON DELETE SET NULL,
  decided_at timestamptz, decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leave_requests_company_idx ON leave_requests (company_id, status);
CREATE INDEX IF NOT EXISTS leave_requests_person_idx ON leave_requests (person_id);

CREATE TABLE IF NOT EXISTS tickets (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  category text NOT NULL, description text NOT NULL,
  priority text NOT NULL DEFAULT 'Medium',
  status text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'In progress', 'Resolved')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS tickets_company_idx ON tickets (company_id, status);

CREATE TABLE IF NOT EXISTS policy_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title text NOT NULL, filename text, chars int NOT NULL DEFAULT 0,
  uploaded_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS policy_chunks (
  doc_id uuid NOT NULL REFERENCES policy_docs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ord int NOT NULL,
  heading text NOT NULL, text text NOT NULL,
  PRIMARY KEY (doc_id, ord)
);
CREATE INDEX IF NOT EXISTS policy_chunks_company_idx ON policy_chunks (company_id);

CREATE TABLE IF NOT EXISTS usage_daily (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day date NOT NULL,
  messages int NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, day)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  action text NOT NULL, detail jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
`;

export const DEFAULT_SETTINGS = {
  leave: { Earned: 18, Sick: 8, Casual: 6 },
  earnedNoticeDays: 3,
  autoApproveUpToDays: 0, // 0 = every request goes to the manager / HR
  contacts: { hr: '', ic: '', eap: '', ethics: '' },
  dailyMessageLimit: 300,
  emailNotifications: true, // leave and ticket updates by email (when the server has email set up)
};
