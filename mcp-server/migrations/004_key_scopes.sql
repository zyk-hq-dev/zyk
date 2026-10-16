-- Key scopes: `mcp` keys use the task API; `webhook` keys may only start workflows.
ALTER TABLE api_keys ADD COLUMN scope text NOT NULL DEFAULT 'mcp' CHECK (scope IN ('mcp', 'webhook'));
