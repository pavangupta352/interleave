"""Buy the last unit of stock with the SQLAlchemy ORM. Safe: SELECT ... FOR UPDATE makes the second
transaction wait for the first to commit and then read the stock it left."""
import json

from sqlalchemy.orm import Session

from models import Order, Product, engine

with Session(engine()) as session, session.begin():
    product = session.get(Product, 1, with_for_update=True)
    bought = product.stock > 0
    if bought:
        product.stock -= 1
        session.add(Order(product_id=1))
print(json.dumps({"bought": bought}))
