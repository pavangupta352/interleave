# Buy the last unit of stock with Active Record. Safe: lock reads the product with SELECT ... FOR UPDATE inside
# the transaction, so the second purchase waits for the first to commit and then reads the stock it left.
require "json"
require_relative "shop"

bought = Product.transaction do
  product = Product.lock.find(1)
  next false unless product.stock > 0

  product.update!(stock: product.stock - 1)
  Order.create!(product_id: 1)
  true
end
puts JSON.generate({ bought: bought })
