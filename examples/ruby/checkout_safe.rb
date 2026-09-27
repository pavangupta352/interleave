# Buy the last unit of stock. Safe: one conditional update decides whether the purchase happens.
require "json"
require "pg"

conn = PG.connect(ENV.fetch("DATABASE_URL"))
begin
  bought = conn.transaction do
    updated = conn.exec_params("UPDATE product SET stock = stock - 1 WHERE id = $1 AND stock > 0 RETURNING stock", [1])
    conn.exec_params("INSERT INTO orders (product_id) VALUES ($1)", [1]) if updated.ntuples == 1
    updated.ntuples == 1
  end
  puts JSON.generate({ bought: bought })
ensure
  conn.close
end
