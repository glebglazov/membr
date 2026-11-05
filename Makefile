.PHONY: run

# Serve on this machine's Tailscale address so other tailnet devices can sign
# in. Without Tailscale, HOST is empty and the server stays on 127.0.0.1.
HOST ?= $(shell tailscale ip -4 2>/dev/null | head -n 1)

# Pass more server options through ARGS, e.g. `make run ARGS="--port 9000"`.
run: node_modules
	bun run serve $(if $(HOST),--host $(HOST)) $(ARGS)

node_modules: package.json bun.lock
	bun install
	@touch node_modules
