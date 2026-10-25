# Buy the last unit of stock with Active Record. Unsafe: the product is read, then updated with the stock
# computed from that read, so two purchases that both read stock 1 both sell it.
require "json"
require_relative "shop"

product = Product.find(1)
stock = product.stock
if stock > 0
  product.update!(stock: stock - 1)
  Order.create!(product_id: 1)
end
puts JSON.generate({ saw_stock: stock, bought: stock > 0 })
