"""Buy the last unit of stock with asyncpg. Safe: one conditional update decides whether the purchase happens."""
import asyncio
import json
import os

import asyncpg


async def main():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        async with conn.transaction():
            stock = await conn.fetchval(
                "UPDATE product SET stock = stock - 1 WHERE id = $1 AND stock > 0 RETURNING stock", 1
            )
            if stock is not None:
                await conn.execute("INSERT INTO orders (product_id) VALUES ($1)", 1)
        print(json.dumps({"bought": stock is not None}))
    finally:
        await conn.close()


asyncio.run(main())
