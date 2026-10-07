CREATE TABLE IF NOT EXISTS flightdeck_pg_org_data_types (
 workspace_id uuid NOT NULL REFERENCES flightdeck_pg_workspaces(id), key text NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(), label text NOT NULL, fields jsonb NOT NULL,
 access jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,key)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_org_data_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, type_key text NOT NULL,
 values jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,type_key) REFERENCES flightdeck_pg_org_data_types(workspace_id,key)
);
CREATE INDEX IF NOT EXISTS org_data_record_type ON flightdeck_pg_org_data_records(workspace_id,type_key);
CREATE TABLE IF NOT EXISTS flightdeck_pg_org_data_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES flightdeck_pg_workspaces(id),
 actor_id uuid NOT NULL REFERENCES flightdeck_pg_actors(id), operation text NOT NULL, target_id text NOT NULL,
 before_value jsonb, after_value jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_napplet_bundles (
 workspace_id uuid NOT NULL REFERENCES flightdeck_pg_workspaces(id),
 key text NOT NULL, version integer NOT NULL CHECK(version>0), title text NOT NULL,
 bridge_version integer NOT NULL CHECK(bridge_version=1), capabilities jsonb NOT NULL,
 html text NOT NULL, sha256 text NOT NULL, created_by_actor_id uuid NOT NULL REFERENCES flightdeck_pg_actors(id),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,key,version)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_napplet_installations (
 workspace_id uuid NOT NULL, key text NOT NULL, version integer NOT NULL,
 revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,key), FOREIGN KEY(workspace_id,key,version)
 REFERENCES flightdeck_pg_napplet_bundles(workspace_id,key,version)
);
CREATE INDEX IF NOT EXISTS org_data_audit_workspace ON flightdeck_pg_org_data_audit(workspace_id,id);

-- Add default capabilities once. A revoked grant is never silently re-created.
INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,permission,created_by_actor_id)
SELECT g.workspace_id,'group',g.id,'workspace',p.permission,w.created_by_actor_id
FROM flightdeck_pg_groups g JOIN flightdeck_pg_workspaces w ON w.id=g.workspace_id
CROSS JOIN (VALUES ('Admins','org_data.read'),('Admins','org_data.write'),('Admins','org_data.schema'),('Admins','napplet.publish'),('Admins','napplet.install'),('People','org_data.read')) p(group_name,permission)
WHERE g.name=p.group_name AND NOT EXISTS (SELECT 1 FROM flightdeck_pg_permission_grants old WHERE old.workspace_id=g.workspace_id AND old.principal_group_id=g.id AND old.resource_type='workspace' AND old.permission=p.permission)
ON CONFLICT DO NOTHING;
