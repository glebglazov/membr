.PHONY: run

# Pass more server options through ARGS, e.g. `make run ARGS="--port 9000"`.
run: node_modules
	bun run serve --tailscale $(ARGS)

node_modules: package.json bun.lock
	bun install
	@touch node_modules
