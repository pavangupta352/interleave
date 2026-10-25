import json
import os
import sys
import threading

import psycopg

# psycopg sends the cancel request on its own connection to the actor endpoint:
# cancel_safe() through libpq's PQcancelCreate, cancel() through the older PQcancel.
with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as connection:
    cancel = connection.cancel if sys.argv[1:] == ["legacy"] else connection.cancel_safe
    timer = threading.Timer(0.3, cancel)
    timer.start()
    try:
        connection.execute("SELECT pg_sleep(30)")
        outcome = "completed"
    except psycopg.errors.QueryCanceled as error:
        outcome = error.sqlstate
    finally:
        timer.cancel()
print(json.dumps(outcome))
