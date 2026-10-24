import json
import os
import threading

import psycopg

# psycopg sends the cancel request on its own connection to the actor endpoint.
with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as connection:
    timer = threading.Timer(0.3, connection.cancel_safe)
    timer.start()
    try:
        connection.execute("SELECT pg_sleep(30)")
        outcome = "completed"
    except psycopg.errors.QueryCanceled as error:
        outcome = error.sqlstate
    finally:
        timer.cancel()
print(json.dumps(outcome))
