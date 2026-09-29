-- EDISS Database Schema
-- Run this to initialize the database

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Profiles (companies/organizations)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_code VARCHAR(20) UNIQUE NOT NULL,
  company_name VARCHAR(200) NOT NULL,
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100) DEFAULT 'India',
  phone VARCHAR(20),
  email VARCHAR(200),
  carn_number VARCHAR(16), -- Consol Agent Registration Number (PAN-based 16-digit)
  customs_house_code VARCHAR(6),
  icegate_code VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  email VARCHAR(200),
  role VARCHAR(20) NOT NULL DEFAULT 'user', -- 'master_admin', 'admin', 'user'
  profile_id UUID REFERENCES profiles(id),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Master Airway Bills (MAWB)
CREATE TABLE IF NOT EXISTS mawbs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mawb_no VARCHAR(20) NOT NULL,
  mawb_date DATE,
  airline_code VARCHAR(3),
  origin VARCHAR(3) NOT NULL,        -- Port of Origin (3-letter IATA)
  destination VARCHAR(3) NOT NULL,   -- Port of Destination (3-letter IATA)
  flight_no VARCHAR(15),
  flight_origin_date DATE,
  igm_no VARCHAR(7),
  igm_date DATE,
  shipment_type CHAR(1) NOT NULL DEFAULT 'T', -- T=Total, P=Part, S=Split
  total_packages INTEGER NOT NULL DEFAULT 0,
  gross_weight DECIMAL(12,3) NOT NULL DEFAULT 0,
  item_description VARCHAR(100),
  special_handling_code VARCHAR(15),
  uld_number VARCHAR(15),
  customs_house_code VARCHAR(6),
  profile_id UUID REFERENCES profiles(id),
  created_by UUID REFERENCES users(id),
  transmission_date TIMESTAMP,
  status VARCHAR(20) DEFAULT 'draft', -- draft, transmitted, acknowledged, error
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- House Airway Bills (HAWB)
CREATE TABLE IF NOT EXISTS hawbs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mawb_id UUID NOT NULL REFERENCES mawbs(id) ON DELETE CASCADE,
  hawb_no VARCHAR(20) NOT NULL,
  hawb_date DATE,
  origin VARCHAR(3) NOT NULL,
  destination VARCHAR(3) NOT NULL,
  shipment_type CHAR(1) NOT NULL DEFAULT 'T',
  total_packages INTEGER NOT NULL DEFAULT 0,
  gross_weight DECIMAL(12,3) NOT NULL DEFAULT 0,
  item_description VARCHAR(100),
  consignee_name VARCHAR(200),
  consignee_address TEXT,
  shipper_name VARCHAR(200),
  shipper_address TEXT,
  profile_id UUID REFERENCES profiles(id),
  created_by UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Consol Manifest (CGM) transmissions
CREATE TABLE IF NOT EXISTS transmissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transmission_type VARCHAR(10) NOT NULL, -- CGM, IGM, EGM
  file_name VARCHAR(200),
  file_content TEXT,
  mawb_id UUID REFERENCES mawbs(id),
  customs_house_code VARCHAR(6),
  profile_id UUID REFERENCES profiles(id),
  sent_by UUID REFERENCES users(id),
  sent_at TIMESTAMP DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'pending', -- pending, sent, acknowledged, error
  ack_content TEXT,
  ack_received_at TIMESTAMP
);

-- Locations
CREATE TABLE IF NOT EXISTS locations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  iata_code VARCHAR(3) UNIQUE NOT NULL,
  city_name VARCHAR(100) NOT NULL,
  country VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE
);

-- Insert default locations
INSERT INTO locations (iata_code, city_name, country) VALUES
  ('DEL', 'Delhi (Indira Gandhi Intl)', 'India'),
  ('BOM', 'Mumbai (Chhatrapati Shivaji)', 'India'),
  ('MAA', 'Chennai', 'India'),
  ('CCU', 'Kolkata', 'India'),
  ('BLR', 'Bangalore', 'India'),
  ('HYD', 'Hyderabad', 'India'),
  ('AMD', 'Ahmedabad', 'India'),
  ('COK', 'Kochi', 'India'),
  ('PVG', 'Shanghai Pudong', 'China'),
  ('PEK', 'Beijing Capital', 'China'),
  ('HKG', 'Hong Kong', 'China'),
  ('SIN', 'Singapore Changi', 'Singapore'),
  ('DXB', 'Dubai', 'UAE'),
  ('LHR', 'London Heathrow', 'UK'),
  ('FRA', 'Frankfurt', 'Germany'),
  ('CDG', 'Paris Charles de Gaulle', 'France'),
  ('AMS', 'Amsterdam Schiphol', 'Netherlands'),
  ('JFK', 'New York JFK', 'USA'),
  ('ORD', 'Chicago O Hare', 'USA'),
  ('LAX', 'Los Angeles', 'USA'),
  ('NRT', 'Tokyo Narita', 'Japan'),
  ('ICN', 'Seoul Incheon', 'South Korea'),
  ('SYD', 'Sydney', 'Australia'),
  ('BKK', 'Bangkok Suvarnabhumi', 'Thailand'),
  ('KUL', 'Kuala Lumpur', 'Malaysia'),
  ('DUS', 'Dusseldorf', 'Germany'),
  ('KOL', 'Kolkata (alt code)', 'India'),
  ('NMI', 'NAVI MUMBAI', 'India')
ON CONFLICT (iata_code) DO NOTHING;

-- Insert default master admin profile
INSERT INTO profiles (profile_code, company_name, customs_house_code, carn_number)
VALUES ('INDEL4', 'ACC Delhi - Default Profile', 'INDEL4', 'AGSYE7618HCNDEL4')
ON CONFLICT (profile_code) DO NOTHING;

-- Insert default admin user (password: admin123 - change in production)
INSERT INTO users (username, password_hash, full_name, role, profile_id)
SELECT 'admin', '$2b$10$rOOH6G/JN2fDaAMk7LhqWeCqjO5Z5a2Q0lO7T7KQBU5gMHXkQzXpW', 'System Admin', 'master_admin', id
FROM profiles WHERE profile_code = 'INDEL4'
ON CONFLICT (username) DO NOTHING;
