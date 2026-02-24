"""Debug script to check Neo4j graph state after Graphiti ingestion."""
import asyncio
import os
from dotenv import load_dotenv
from neo4j import AsyncGraphDatabase

load_dotenv()

async def check_db():
    uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    user = os.getenv("NEO4J_USERNAME", "neo4j")
    password = os.getenv("NEO4J_PASSWORD", "")
    
    print(f"Connecting to {uri}...")
    driver = AsyncGraphDatabase.driver(uri, auth=(user, password))
    
    async with driver.session() as session:
        # Check labels
        result = await session.run("CALL db.labels()")
        records = await result.data()
        labels = [r["label"] for r in records]
        print(f"Labels in DB: {labels}")
        
        # Count nodes
        result = await session.run("MATCH (n) RETURN count(n) as count")
        record = await result.single()
        print(f"Total nodes: {record['count']}")
        
        # Count by label
        for label in labels:
            result = await session.run(f"MATCH (n:{label}) RETURN count(n) as count")
            record = await result.single()
            print(f"  {label}: {record['count']} nodes")
        
        # Sample some nodes
        if record["count"] > 0:
            result = await session.run("MATCH (n) RETURN labels(n) as labels, properties(n) as props LIMIT 5")
            records = await result.data()
            print("\nSample nodes:")
            for r in records:
                props_str = str(r["props"])[:100] + "..." if len(str(r["props"])) > 100 else str(r["props"])
                print(f"  {r['labels']}: {props_str}")
    
    await driver.close()
    print("\nDone.")

if __name__ == "__main__":
    asyncio.run(check_db())
