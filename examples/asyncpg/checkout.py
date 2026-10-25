"""Buy the last unit of stock with asyncpg. Unsafe: the stock check and the update are separate statements."""
import asyncio
import json
import os

import asyncpg


async def main():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        stock = await conn.fetchval("SELECT stock FROM product WHERE id = $1", 1)
        if stock > 0:
            await conn.execute("UPDATE product SET stock = $1 WHERE id = $2", stock - 1, 1)
            await conn.execute("INSERT INTO orders (product_id) VALUES ($1)", 1)
        print(json.dumps({"saw_stock": stock, "bought": stock > 0}))
    finally:
        await conn.close()


asyncio.run(main())
