# Buy the last unit of stock. Unsafe: the stock check and the update are separate statements.
require "json"
require "pg"

conn = PG.connect(ENV.fetch("DATABASE_URL"))
begin
  stock = conn.exec_params("SELECT stock FROM product WHERE id = $1", [1]).getvalue(0, 0).to_i
  if stock > 0
    conn.exec_params("UPDATE product SET stock = $1 WHERE id = $2", [stock - 1, 1])
    conn.exec_params("INSERT INTO orders (product_id) VALUES ($1)", [1])
  end
  puts JSON.generate({ saw_stock: stock, bought: stock > 0 })
ensure
  conn.close
end
