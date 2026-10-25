from django.db import models


class Product(models.Model):
    stock = models.IntegerField()

    class Meta:
        db_table = "product"


class Order(models.Model):
    product = models.ForeignKey(Product, on_delete=models.PROTECT)

    class Meta:
        db_table = "orders"
