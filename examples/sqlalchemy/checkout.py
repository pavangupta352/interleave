"""Buy the last unit of stock with the SQLAlchemy ORM. Unsafe: the session reads the product, then writes back
the stock it computed, so two transactions that both read stock 1 both sell it."""
import json

from sqlalchemy.orm import Session

from models import Order, Product, engine

with Session(engine()) as session, session.begin():
    product = session.get(Product, 1)
    stock = product.stock
    if stock > 0:
        product.stock = stock - 1
        session.add(Order(product_id=1))
print(json.dumps({"saw_stock": stock, "bought": stock > 0}))
