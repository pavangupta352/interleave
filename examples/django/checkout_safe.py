"""Buy the last unit of stock with the Django ORM. Safe: select_for_update() makes the second purchase wait
for the first to commit and then read the stock it left."""
import json
import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "shop_settings")
django.setup()

from django.db import transaction  # noqa: E402  (needs django.setup())

from shop.models import Order, Product  # noqa: E402

with transaction.atomic():
    product = Product.objects.select_for_update().get(pk=1)
    bought = product.stock > 0
    if bought:
        product.stock -= 1
        product.save(update_fields=["stock"])
        Order.objects.create(product=product)
print(json.dumps({"bought": bought}))
