import asyncio
import os
import psycopg
from dotenv import load_dotenv
import time

load_dotenv()

async def test_connect(url, label):
    print(f"\n--- Testing {label} ---")
    safe_url = url.split('@')[-1] if '@' in url else '...'
    print(f"Target: {safe_url}")
    
    try:
        start = time.time()
        conn = await asyncio.wait_for(
            psycopg.AsyncConnection.connect(url, autocommit=True),
            timeout=10.0
        )
        duration = time.time() - start
        print(f"SUCCESS! Connected in {duration:.2f}s")
        await conn.close()
        return True
    except asyncio.TimeoutError:
        print("FAILED: Connection Timed Out (10s)")
        return False
    except Exception as e:
        print(f"FAILED: {e}")
        return False

async def main():
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("No DATABASE_URL found in .env")
        return

    # Test 1: Configured URL
    print("Test 1: Connecting to configured DATABASE_URL (likely Pooler port 6543)")
    await test_connect(db_url, "Configured URL")

    # Test 2: Try Direct Port 5432 (if on pooler)
    if ":6543" in db_url:
        print("\nTest 2: Attempting to switch port 6543 -> 5432 (Direct Connection)")
        # Usually pooler host is different from direct host, but sometimes swapping port works 
        # if using the direct host alias. 
        # However, accurate direct host is usually db.ref.supabase.co
        # Let's try simple port swap first.
        direct_url = db_url.replace(":6543", ":5432")
        await test_connect(direct_url, "Port 5432 Swap")
    
    # Test 3: Try resolving hostname (debug DNS)
    try:
        import socket
        host = db_url.split('@')[1].split(':')[0]
        print(f"Test 3: DNS Resolution for {host}")
        ip = socket.gethostbyname(host)
        print(f"Resolved to: {ip}")
    except Exception as e:
        print(f"DNS Resolution Failed: {e}")

if __name__ == "__main__":
    if os.name == 'nt':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
