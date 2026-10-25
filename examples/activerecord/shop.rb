# The shop's tables as Active Record models, connected to the actor's own endpoint.
require "active_record"

ActiveRecord::Base.establish_connection(ENV.fetch("DATABASE_URL"))

class Product < ActiveRecord::Base
  self.table_name = "product"
end

class Order < ActiveRecord::Base
  self.table_name = "orders"
end
