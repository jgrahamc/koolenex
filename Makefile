SERVER_PID := .server.pid
CLIENT_PID := .client.pid

kill-tree = pids=$$(pstree -p $(1) 2>/dev/null | grep -oP '\(\K[0-9]+' | tac); kill $$pids 2>/dev/null
kill-pid = [ -f $($(1)_PID) ] && { $(call kill-tree,$$(cat $($(1)_PID))); rm -f $($(1)_PID); } || true
save-pid = echo $$! > $($(1)_PID)

.PHONY: server server-open stop-server client stop-client start stop test lint format

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

lint:
	npx eslint --max-warnings 0 server/
	cd client && npx eslint --max-warnings 0 src/

format:
	npx prettier --write server/ tests/
	cd client && npx prettier --write src/
