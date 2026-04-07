SERVER_PID := .server.pid
CLIENT_PID := .client.pid

kill-pid = [ -f $($(1)_PID) ] && { kill -0 $$(cat $($(1)_PID)) 2>/dev/null && pkill -P $$(cat $($(1)_PID)); kill $$(cat $($(1)_PID)); rm $($(1)_PID); } || true
save-pid = echo $$! > $($(1)_PID)

.PHONY: server stop-server client stop-client start stop test lint format

server: stop-server
	@node server/index.ts & $(call save-pid,SERVER)

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
	npx eslint server/
	cd client && npx eslint src/

format:
	npx prettier --write server/ tests/
	cd client && npx prettier --write src/
