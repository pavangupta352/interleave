"""Buy the last unit of stock. Unsafe: the stock check and the update are separate statements."""
import json
import os

import psycopg

with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
    (stock,) = conn.execute("SELECT stock FROM product WHERE id = %s", (1,)).fetchone()
    if stock > 0:
        conn.execute("UPDATE product SET stock = %s WHERE id = %s", (stock - 1, 1))
        conn.execute("INSERT INTO orders (product_id) VALUES (%s)", (1,))
    print(json.dumps({"saw_stock": stock, "bought": stock > 0}))
