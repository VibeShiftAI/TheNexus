import os
import asyncio
import psycopg
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

async def run_migrations():
    if not DATABASE_URL:
        print("DATABASE_URL not set")
        return

    print("Connecting to database...")
    try:
        # Disable prepared statements for pooler compatibility
        async with await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True, prepare_threshold=None) as aconn:
            async with aconn.cursor() as acur:
                
                # Migration 1: Add LangGraph columns
                print("Running migration_add_langgraph_columns.sql...")
                try:
                    with open("db/migration_add_langgraph_columns.sql", "r") as f:
                        sql = f.read()
                        await acur.execute(sql)
                        print("Done.")
                except FileNotFoundError:
                    print("Skipping (file not found)")

                # Migration 2: Add more columns
                print("Running migration_add_more_columns.sql...")
                try:
                    with open("db/migration_add_more_columns.sql", "r") as f:
                        sql = f.read()
                        await acur.execute(sql)
                        print("Done.")
                except FileNotFoundError:
                    print("Skipping (file not found)")

        print("All migrations applied successfully.")
    except Exception as e:
        print(f"Migration failed: {e}")

if __name__ == "__main__":
    if os.name == 'nt':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(run_migrations())
