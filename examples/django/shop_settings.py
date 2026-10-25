"""Django settings for the actor programs. Interleave supplies the actor's endpoint in the standard
libpq PG* variables, so only the database name is set here; psycopg reads the rest."""
import os

DATABASES = {"default": {"ENGINE": "django.db.backends.postgresql", "NAME": os.environ["PGDATABASE"]}}
INSTALLED_APPS = ["shop"]
DEFAULT_AUTO_FIELD = "django.db.models.AutoField"
USE_TZ = True
