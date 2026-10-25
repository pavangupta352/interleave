"""Buy the last unit of stock with the Django ORM. Unsafe: the product is read, then saved with the stock
computed from that read, so two purchases that both read stock 1 both sell it."""
import json
import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "shop_settings")
django.setup()

from shop.models import Order, Product  # noqa: E402  (needs django.setup())

product = Product.objects.get(pk=1)
stock = product.stock
if stock > 0:
    product.stock = stock - 1
    product.save(update_fields=["stock"])
    Order.objects.create(product=product)
print(json.dumps({"saw_stock": stock, "bought": stock > 0}))
