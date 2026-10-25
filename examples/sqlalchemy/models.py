"""The shop's tables as SQLAlchemy ORM classes, and an engine for the actor's own endpoint."""
import os

from sqlalchemy import ForeignKey, create_engine, make_url
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.pool import NullPool


class Base(DeclarativeBase):
    pass


class Product(Base):
    __tablename__ = "product"
    id: Mapped[int] = mapped_column(primary_key=True)
    stock: Mapped[int]


class Order(Base):
    __tablename__ = "orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("product.id"))


def engine():
    # DATABASE_URL is the actor's own endpoint; connect to it with the psycopg 3 dialect.
    url = make_url(os.environ["DATABASE_URL"]).set(drivername="postgresql+psycopg")
    return create_engine(url, poolclass=NullPool)
