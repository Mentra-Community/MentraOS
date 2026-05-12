# MongoDB Connection Test

Simple Python script to test MongoDB Atlas connection using `uv` for dependency management.

## Quick Start

```bash
# Install dependencies and run
uv run test_connection.py
```

That's it! `uv` will automatically:

- Create a virtual environment
- Install dependencies from pyproject.toml
- Run the script

## Manual Setup (if needed)

```bash
# Sync dependencies
uv sync

# Run the script
uv run test_connection.py
```

## What it does

- Tests connection to MongoDB Atlas
- Displays server information
- Lists available databases and collections
- Provides the connection string for your `.env` file

## Next Steps

If the connection test succeeds, copy the `MONGO_URL` from the output and add it to your `.env` file:

```bash
# In /cloud/.env
MONGO_URL=mongodb+srv://readWrite:readWritePw@sisu.zbkrgfu.mongodb.net/?appName=sisu
```

Then restart your development server:

```bash
cd ..
bun run dev:stop && bun run dev
```
