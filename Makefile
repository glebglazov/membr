.PHONY: run

# Runs the server in this terminal. config.json in the data directory sets its options.
run: node_modules
	bun run serve

node_modules: package.json bun.lock
	bun install
	@touch node_modules
