"""Buy the last unit of stock. Safe: one conditional update decides whether the purchase happens."""
import json
import os

import psycopg

with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
    with conn.transaction():
        row = conn.execute(
            "UPDATE product SET stock = stock - 1 WHERE id = %s AND stock > 0 RETURNING stock", (1,)
        ).fetchone()
        if row is not None:
            conn.execute("INSERT INTO orders (product_id) VALUES (%s)", (1,))
    print(json.dumps({"bought": row is not None}))
