// Command checkout buys the last unit of stock with GORM. Unsafe: the product is
// read, then updated with the stock computed from that read, so two purchases
// that both read stock 1 both sell it.
package main

import (
	"encoding/json"
	"log"
	"os"

	"example.com/gorm-checkout/shop"
)

func main() {
	db, err := shop.Open()
	if err != nil {
		log.Fatal(err)
	}
	var product shop.Product
	if err := db.First(&product, 1).Error; err != nil {
		log.Fatal(err)
	}
	stock := product.Stock
	if stock > 0 {
		if err := db.Model(&product).Update("stock", stock-1).Error; err != nil {
			log.Fatal(err)
		}
		if err := db.Create(&shop.Order{ProductID: 1}).Error; err != nil {
			log.Fatal(err)
		}
	}
	result := struct {
		SawStock int  `json:"saw_stock"`
		Bought   bool `json:"bought"`
	}{stock, stock > 0}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		log.Fatal(err)
	}
}
