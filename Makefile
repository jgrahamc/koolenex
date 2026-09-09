SERVER_PID := .server.pid
CLIENT_PID := .client.pid

# Portable: walk the descendants of $(1) via pgrep -P, prepending each new
# child so the final list is children-first. pgrep is on both Linux and BSD;
# avoids the GNU-only `grep -P` and `tac` used previously.
kill-tree = pids="$(1)"; q="$(1)"; while [ -n "$$q" ]; do next=""; for p in $$q; do kids=$$(pgrep -P $$p 2>/dev/null || true); for k in $$kids; do pids="$$k $$pids"; next="$$next $$k"; done; done; q="$$next"; done; kill $$pids 2>/dev/null || true
kill-pid = [ -f $($(1)_PID) ] && { $(call kill-tree,$$(cat $($(1)_PID))); rm -f $($(1)_PID); } || true
save-pid = echo $$! > $($(1)_PID)

.PHONY: server server-open stop-server client stop-client start stop test lint format typecheck

server: stop-server
	@node server/index.ts & $(call save-pid,SERVER)

server-open: stop-server
	@node server/index.ts --cors-open & $(call save-pid,SERVER)

stop-server:
	@$(call kill-pid,SERVER)

client: stop-client
	@cd client && npx vite & $(call save-pid,CLIENT)

stop-client:
	@$(call kill-pid,CLIENT)

start: server client

stop: stop-server stop-client

test:
	node --test tests/*.test.ts

typecheck:
	npx tsc --noEmit -p tsconfig.json
	cd client && npx tsc --noEmit

lint:
	npx eslint --max-warnings 0 server/
	cd client && npx eslint --max-warnings 0 src/

format:
	npx prettier --write server/ tests/
	cd client && npx prettier --write src/
